import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiFailure, ApiIssue, Dispense, requestJson } from './api';
import { FieldErrors } from './field-errors';
import { Icon } from './icon';

interface Submission {
  medicine_code: string;
  patient_ref: string;
  quantity: number;
  dispensed_at: string;
  authorisation_ref: string | null;
  idempotency_key: string;
}

/** Create a random idempotency key; randomUUID is unavailable on insecure origins such as plain-HTTP hosts. */
function createIdempotencyKey(): string {
  // getRandomValues works in every browser context, unlike crypto.randomUUID.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Format a timestamp for a Johannesburg datetime-local input, independent of browser timezone. */
function formatBusinessTime(value: Date): string {
  // Johannesburg uses UTC+02:00; display that business offset rather than the device's zone.
  return new Date(value.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

@Component({
  selector: 'app-capture',
  imports: [FormsModule, Icon, RouterLink, FieldErrors],
  template: `
    <div class="page-header"><div>
      <h1>Capture dispense</h1>
      <p>Record medicine handed to a patient. The server validates it against the rule in force at the dispense time.</p>
    </div></div>
    <!-- Show confirmed success and require an explicit new operation before saving again. -->
    @if (recorded(); as dispense) {
      <div class="alert success"><app-icon name="check" /><div class="alert-body">
        <p role="status">Dispense recorded: {{ dispense.id }}.</p>
        <p class="hint">{{ dispense.quantity }} × {{ dispense.medicine_code }} for {{ dispense.patient_ref }}</p>
        <div class="actions">
          <a class="button" routerLink="/ledger" [queryParams]="{ patient: dispense.patient_ref }"><app-icon name="ledger" />View patient ledger</a>
          <button type="button" class="secondary" (click)="startNew()"><app-icon name="plus" />New dispense</button>
        </div>
      </div></div>
    }
    @if (uncertain()) {
      <div class="alert warning" role="alert"><app-icon name="alert" /><div class="alert-body">
        <p>Outcome unknown. Retry the same request to confirm it.</p>
        <p class="hint">The fields are locked so the retry carries the same idempotency key and cannot record twice.</p>
      </div></div>
    }
    @if (generalIssues().length) {
      <div class="alert error" role="alert"><app-icon name="alert" /><div class="alert-body">
        <app-field-errors field="idempotency_key" [issues]="issues()" />
        <app-field-errors field="body" [issues]="issues()" />
      </div></div>
    }
    <div class="split">
      <!-- Submit or replay the pending payload through one guarded handler. -->
      <form class="card" (ngSubmit)="submit()">
        <div class="card-body">
          <fieldset class="field-grid" [disabled]="busy() || uncertain() || recorded() !== null">
            <div [class.invalid]="hasIssue('medicine_code')">
              <label>Medicine code<input name="medicine" class="mono" [(ngModel)]="form.medicine_code" required maxlength="80" placeholder="SEED-0000" aria-describedby="medicine_code-errors"></label>
              <app-field-errors field="medicine_code" [issues]="issues()" />
            </div>
            <div [class.invalid]="hasIssue('patient_ref')">
              <label>Patient reference<input name="patient" [(ngModel)]="form.patient_ref" required maxlength="120" placeholder="patient-0000" aria-describedby="patient_ref-errors"></label>
              <app-field-errors field="patient_ref" [issues]="issues()" />
            </div>
            <div [class.invalid]="hasIssue('quantity')">
              <label>Quantity<input name="quantity" type="number" [(ngModel)]="form.quantity" required min="1" max="2147483647" step="1" aria-describedby="quantity-errors"></label>
              <app-field-errors field="quantity" [issues]="issues()" />
            </div>
            <div [class.invalid]="hasIssue('dispensed_at')">
              <label>Dispensed at (Africa/Johannesburg)<input name="occurred" type="datetime-local" [(ngModel)]="form.occurred" required step="1" aria-describedby="dispensed_at-errors"></label>
              <app-field-errors field="dispensed_at" [issues]="issues()" />
            </div>
            <div class="wide" [class.invalid]="hasIssue('authorisation_ref')">
              <label>Authorisation reference<input name="authorisation" [(ngModel)]="form.authorisation_ref" maxlength="120" aria-describedby="authorisation_ref-errors"></label>
              <p class="hint">Required only when the rule in force demands authorisation.</p>
              <app-field-errors field="authorisation_ref" [issues]="issues()" />
            </div>
          </fieldset>
          <div class="actions">
            <button type="submit" [disabled]="busy() || recorded() !== null">
              <app-icon [name]="uncertain() ? 'retry' : 'check'" />{{ busy() ? 'Saving…' : uncertain() ? 'Retry same request' : 'Record dispense' }}
            </button>
          </div>
        </div>
      </form>
      <aside class="card aside"><div class="card-body">
        <h2>What the server checks</h2>
        <ol>
          <li>The medicine is active and has a rule in force at the dispense time.</li>
          <li>Quantity is within the single-dispense limit.</li>
          <li>The patient's 30-day total stays within the allowance, including later dispenses a backdated entry affects.</li>
          <li>An authorisation reference is present when required.</li>
        </ol>
        <p class="hint">Every violated rule is shown beside its field at once.</p>
      </div></aside>
    </div>
  `,
})
export class CaptureDispense implements OnInit {
  // Initialize route selection and asynchronous form state.
  private readonly route = inject(ActivatedRoute);
  readonly busy = signal(false);
  readonly uncertain = signal(false);
  readonly issues = signal<ApiIssue[]>([]);
  readonly recorded = signal<Dispense | null>(null);
  // Errors that belong to no form control are shown in a banner above the form.
  readonly generalIssues = computed(() => this.issues().filter(issue => issue.field === 'body' || issue.field === 'idempotency_key'));
  form = {
    medicine_code: this.route.snapshot.queryParamMap.get('medicine') ?? '',
    patient_ref: '', quantity: 1, occurred: formatBusinessTime(new Date()), authorisation_ref: '',
  };
  private pending: Submission | null = null;
  private fingerprint = '';
  private key = '';

  /** Recover an unresolved request after navigation or a page reload. */
  ngOnInit(): void {
    // Keep a pending key in tab-local storage until the server outcome is known.
    const saved = sessionStorage.getItem('pharmacy.pending');
    if (!saved) return;
    try {
      const pending = JSON.parse(saved) as Submission;
      this.form = { medicine_code: pending.medicine_code, patient_ref: pending.patient_ref,
        quantity: pending.quantity, occurred: formatBusinessTime(new Date(pending.dispensed_at)),
        authorisation_ref: pending.authorisation_ref ?? '' };
      this.pending = pending;
      this.uncertain.set(true);
    } catch {
      // Discard unreadable local state so the form remains usable.
      sessionStorage.removeItem('pharmacy.pending');
    }
  }

  /** Persist one operation, retaining its exact payload when the response is uncertain. */
  async submit(): Promise<void> {
    // Prevent double clicks and repeated saves after confirmed success.
    if (this.busy() || this.recorded()) return;
    this.issues.set([]);
    if (!this.uncertain()) {
      const values = { medicine_code: this.form.medicine_code, patient_ref: this.form.patient_ref,
        quantity: this.form.quantity, dispensed_at: new Date(`${this.form.occurred}+02:00`).toISOString(),
        authorisation_ref: this.form.authorisation_ref || null };
      // Reuse a definitive rejected outcome only while its payload remains unchanged.
      const fingerprint = JSON.stringify(values);
      if (fingerprint !== this.fingerprint) this.key = createIdempotencyKey();
      this.fingerprint = fingerprint;
      this.pending = { ...values, idempotency_key: this.key };
    }
    this.busy.set(true);
    try {
      // Save before sending so a reload can safely confirm an in-flight operation.
      sessionStorage.setItem('pharmacy.pending', JSON.stringify(this.pending));
      const dispense = await requestJson<Dispense>('/dispenses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.pending),
      });
      this.recorded.set(dispense);
      this.uncertain.set(false);
      sessionStorage.removeItem('pharmacy.pending');
    } catch (error) {
      // Only a definite client rejection permits editing; network and server failures require replay.
      if (error instanceof ApiFailure && error.status < 500) {
        this.issues.set(error.issues);
        this.uncertain.set(false);
        sessionStorage.removeItem('pharmacy.pending');
      } else {
        this.uncertain.set(true);
      }
    } finally {
      // Release the submit control for a safe retry or corrected operation.
      this.busy.set(false);
    }
  }

  /** Highlight a control when the server rejected its value. */
  hasIssue(field: string): boolean {
    return this.issues().some(issue => issue.field === field);
  }

  /** Begin another dispense only after the previous operation is confirmed. */
  startNew(): void {
    // Retain patient and medicine selections, but reset operation identity and transient state.
    this.recorded.set(null);
    this.issues.set([]);
    this.pending = null;
    this.fingerprint = '';
    this.key = '';
    this.form.quantity = 1;
    this.form.authorisation_ref = '';
    this.form.occurred = formatBusinessTime(new Date());
  }
}

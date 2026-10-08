import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiFailure, ApiIssue, Dispense, requestJson } from './api';
import { FieldErrors } from './field-errors';

interface Submission {
  medicine_code: string;
  patient_ref: string;
  quantity: number;
  dispensed_at: string;
  authorisation_ref: string | null;
  idempotency_key: string;
}

/** Format a timestamp for a Johannesburg datetime-local input, independent of browser timezone. */
function formatBusinessTime(value: Date): string {
  // Johannesburg uses UTC+02:00; display that business offset rather than the device's zone.
  return new Date(value.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 19);
}

@Component({
  selector: 'app-capture',
  imports: [FormsModule, RouterLink, FieldErrors],
  template: `
    <h1>Capture dispense</h1>
    <!-- Submit or replay the pending payload through one guarded handler. -->
    <form (ngSubmit)="submit()">
      <fieldset [disabled]="busy() || uncertain() || recorded() !== null">
        <label>Medicine code<input name="medicine" [(ngModel)]="form.medicine_code" required maxlength="80" aria-describedby="medicine_code-errors"></label>
        <app-field-errors field="medicine_code" [issues]="issues()" />
        <label>Patient reference<input name="patient" [(ngModel)]="form.patient_ref" required maxlength="120" aria-describedby="patient_ref-errors"></label>
        <app-field-errors field="patient_ref" [issues]="issues()" />
        <label>Quantity<input name="quantity" type="number" [(ngModel)]="form.quantity" required min="1" max="2147483647" step="1" aria-describedby="quantity-errors"></label>
        <app-field-errors field="quantity" [issues]="issues()" />
        <label>Dispensed at (Africa/Johannesburg)<input name="occurred" type="datetime-local" [(ngModel)]="form.occurred" required step="1" aria-describedby="dispensed_at-errors"></label>
        <app-field-errors field="dispensed_at" [issues]="issues()" />
        <label>Authorisation reference<input name="authorisation" [(ngModel)]="form.authorisation_ref" maxlength="120" aria-describedby="authorisation_ref-errors"></label>
        <app-field-errors field="authorisation_ref" [issues]="issues()" />
      </fieldset>
      <app-field-errors field="idempotency_key" [issues]="issues()" />
      <app-field-errors field="body" [issues]="issues()" />
      @if (uncertain()) { <p role="alert" class="error">Outcome unknown. Retry the same request to confirm it.</p> }
      <button type="submit" [disabled]="busy() || recorded() !== null">
        {{ busy() ? 'Saving…' : uncertain() ? 'Retry same request' : 'Record dispense' }}
      </button>
    </form>
    <!-- Show confirmed success and require an explicit new operation before saving again. -->
    @if (recorded(); as dispense) {
      <p role="status" class="success">Dispense recorded: {{ dispense.id }}.</p>
      <a routerLink="/ledger" [queryParams]="{ patient: dispense.patient_ref }">View patient ledger</a>
      <button type="button" (click)="startNew()">New dispense</button>
    }
  `,
})
export class CaptureDispense implements OnInit {
  // Initialize route selection and asynchronous form state.
  private readonly route = inject(ActivatedRoute);
  readonly busy = signal(false);
  readonly uncertain = signal(false);
  readonly issues = signal<ApiIssue[]>([]);
  readonly recorded = signal<Dispense | null>(null);
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
      if (fingerprint !== this.fingerprint) this.key = crypto.randomUUID();
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

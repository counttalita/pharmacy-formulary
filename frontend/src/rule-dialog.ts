import { AfterViewInit, Component, ElementRef, input, OnInit, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiFailure, ApiIssue, describeError, requestJson, Rule } from './api';
import { FieldErrors } from './field-errors';
import { Icon } from './icon';

const DAY = 24 * 60 * 60 * 1000;
const OFFSET = 2 * 60 * 60 * 1000;
const LIMITS = [
  { key: 'max_quantity_per_dispense', label: 'Per dispense' },
  { key: 'max_quantity_per_30_days', label: 'Per 30 days' },
] as const;

/** Johannesburg calendar date (yyyy-mm-dd) for an instant, independent of the browser timezone. */
export function businessDate(value: Date | string): string {
  // Johannesburg is UTC+02:00 without DST; shift then read the UTC date.
  return new Date(new Date(value).getTime() + OFFSET).toISOString().slice(0, 10);
}

interface RuleForm {
  effective_from: string;
  max_quantity_per_dispense: number | null;
  max_quantity_per_30_days: number | null;
  requires_authorisation: boolean;
}

@Component({
  selector: 'app-rule-dialog',
  imports: [FormsModule, FieldErrors, Icon],
  template: `
    <!-- Native modal dialog: focus is trapped and Escape closes it unless a save is in flight. -->
    <dialog #dialog class="modal" aria-labelledby="rule-dialog-title" aria-describedby="rule-dialog-desc"
            (cancel)="busy() && $event.preventDefault()" (close)="closed.emit()">
      <form (ngSubmit)="submit()">
        <header class="modal-header">
          <div>
            <h2 id="rule-dialog-title">{{ base() ? 'Update rule' : 'Add rule' }}</h2>
            <p id="rule-dialog-desc">
              @if (base()) { Creates a new version from the chosen date. The current version ends the day before, and earlier dispenses keep the limits they were checked against. }
              @else { Adds a rule version for {{ code() }} starting on the chosen date. }
            </p>
          </div>
          <button type="button" class="icon-button" aria-label="Close" [disabled]="busy()" (click)="close()"><app-icon name="close" /></button>
        </header>
        <div class="modal-body">
          @if (generalIssues().length) {
            <div class="alert error" role="alert"><app-icon name="alert" /><div class="alert-body">
              <app-field-errors field="body" [issues]="issues()" />
              <app-field-errors field="medicine_code" [issues]="issues()" />
            </div></div>
          }
          @if (isBackdated()) {
            <div class="alert warning"><app-icon name="alert" /><div class="alert-body">
              <p>This date is in the past.</p>
              <p class="hint">Dispenses already recorded keep their original rule. Only new or backdated captures use this version.</p>
            </div></div>
          }
          <fieldset class="field-grid" [disabled]="busy()">
            <div class="wide" [class.invalid]="hasIssue('effective_from')">
              <label>Effective from (Africa/Johannesburg)
                <input id="rule-effective-from" name="effective_from" type="date" [(ngModel)]="form.effective_from" required min="2000-01-01" max="2100-12-31" aria-describedby="effective_from-errors">
              </label>
              <app-field-errors field="effective_from" [issues]="issues()" />
            </div>
            <div [class.invalid]="hasIssue('max_quantity_per_dispense')">
              <label>Per dispense
                <input id="rule-per-dispense" name="max_quantity_per_dispense" type="number" [(ngModel)]="form.max_quantity_per_dispense" required min="1" max="2147483647" step="1" aria-describedby="max_quantity_per_dispense-errors">
              </label>
              <app-field-errors field="max_quantity_per_dispense" [issues]="issues()" />
            </div>
            <div [class.invalid]="hasIssue('max_quantity_per_30_days')">
              <label>Per 30 days
                <input id="rule-per-30-days" name="max_quantity_per_30_days" type="number" [(ngModel)]="form.max_quantity_per_30_days" required min="1" max="2147483647" step="1" aria-describedby="max_quantity_per_30_days-errors">
              </label>
              <app-field-errors field="max_quantity_per_30_days" [issues]="issues()" />
            </div>
            <div class="wide" [class.invalid]="hasIssue('requires_authorisation')">
              <label class="check">
                <input id="rule-authorisation" name="requires_authorisation" type="checkbox" [(ngModel)]="form.requires_authorisation">
                Authorisation required
              </label>
              <app-field-errors field="requires_authorisation" [issues]="issues()" />
            </div>
          </fieldset>
          @if (base()) {
            <div class="change-summary" aria-live="polite">
              <span class="change-title">Changes</span>
              @for (change of changes(); track change.label) {
                <span class="change"><b>{{ change.label }}</b> {{ change.from }} <app-icon name="right" /> <strong>{{ change.to }}</strong></span>
              } @empty { <span class="muted">No limits changed yet.</span> }
            </div>
          }
        </div>
        <footer class="modal-footer">
          <button type="button" class="secondary" [disabled]="busy()" (click)="close()">Cancel</button>
          <button id="rule-save" type="submit" [disabled]="busy() || (base() !== null && !changes().length)">
            <app-icon name="check" />{{ busy() ? 'Saving…' : base() ? 'Save new version' : 'Add rule' }}
          </button>
        </footer>
      </form>
    </dialog>
  `,
})
export class RuleDialog implements OnInit, AfterViewInit {
  // The medicine to version and, for updates, the rule whose limits pre-fill the form.
  readonly code = input.required<string>();
  readonly base = input<Rule | null>(null);
  readonly saved = output<Rule>();
  readonly closed = output<void>();
  readonly busy = signal(false);
  readonly issues = signal<ApiIssue[]>([]);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  readonly today = businessDate(new Date());
  form: RuleForm = { effective_from: this.today, max_quantity_per_dispense: null, max_quantity_per_30_days: null, requires_authorisation: false };

  /** Pre-fill from the base rule before the first render. */
  ngOnInit(): void {
    const rule = this.base();
    if (rule) {
      // A version cannot start on its base's start date; default to the day after if that is later than today.
      const nextDay = businessDate(new Date(new Date(rule.effective_from).getTime() + DAY));
      this.form = {
        effective_from: nextDay > this.today ? nextDay : this.today,
        max_quantity_per_dispense: rule.max_quantity_per_dispense,
        max_quantity_per_30_days: rule.max_quantity_per_30_days,
        requires_authorisation: rule.requires_authorisation,
      };
    }
  }

  /** Open as a modal once the dialog element exists. */
  ngAfterViewInit(): void {
    this.dialog().nativeElement.showModal();
  }

  /** Limits that differ from the base rule, for the before → after summary. */
  changes(): { label: string; from: string; to: string }[] {
    const rule = this.base();
    if (!rule) return [];
    const result: { label: string; from: string; to: string }[] = LIMITS
      .filter(limit => this.form[limit.key] !== rule[limit.key])
      .map(limit => ({ label: limit.label, from: String(rule[limit.key]), to: String(this.form[limit.key] ?? '—') }));
    if (this.form.requires_authorisation !== rule.requires_authorisation) {
      const word = (value: boolean) => (value ? 'Required' : 'Not required');
      result.push({ label: 'Authorisation', from: word(rule.requires_authorisation), to: word(this.form.requires_authorisation) });
    }
    return result;
  }

  /** Warn before a version that starts in the past. */
  isBackdated(): boolean {
    return !!this.form.effective_from && this.form.effective_from < this.today;
  }

  /** Errors that belong to no single control are shown above the form. */
  generalIssues(): ApiIssue[] {
    return this.issues().filter(issue => issue.field === 'body' || issue.field === 'medicine_code');
  }

  hasIssue(field: string): boolean {
    return this.issues().some(issue => issue.field === field);
  }

  /** Mirror the server's rules locally so obvious mistakes never leave the browser. */
  private validate(): ApiIssue[] {
    const issues: ApiIssue[] = [];
    const { effective_from: start, max_quantity_per_dispense: single, max_quantity_per_30_days: rolling } = this.form;
    if (!start) issues.push({ code: 'invalid_input', field: 'effective_from', message: 'Choose a start date.' });
    else if (start < '2000-01-01' || start > '2100-12-31') issues.push({ code: 'invalid_input', field: 'effective_from', message: 'Choose a date between 2000 and 2100.' });
    for (const [field, value] of [['max_quantity_per_dispense', single], ['max_quantity_per_30_days', rolling]] as const) {
      if (value === null || !Number.isInteger(value) || value < 1) issues.push({ code: 'invalid_input', field, message: 'Enter a whole number of at least 1.' });
    }
    if (single !== null && rolling !== null && rolling < single) {
      issues.push({ code: 'rolling_below_single', field: 'max_quantity_per_30_days', message: 'The 30-day limit must be at least the per-dispense limit.' });
    }
    return issues;
  }

  /** Create the new version; keep the dialog open with the entered values on any failure. */
  async submit(): Promise<void> {
    if (this.busy()) return;
    const local = this.validate();
    this.issues.set(local);
    if (local.length) return;
    this.busy.set(true);
    try {
      const rule = await requestJson<Rule>(`/medicines/${encodeURIComponent(this.code())}/rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.form),
      });
      this.saved.emit(rule);
    } catch (error) {
      // Field errors map to controls; transport failures get a general message.
      this.issues.set(error instanceof ApiFailure && error.issues?.length
        ? error.issues : [{ code: 'network', field: 'body', message: describeError(error) }]);
    } finally {
      this.busy.set(false);
    }
  }

  close(): void {
    if (!this.busy()) this.dialog().nativeElement.close();
  }
}

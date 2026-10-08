import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { describeError, Medicine, requestJson, Rule } from './api';
import { Icon } from './icon';

@Component({
  selector: 'app-medicine-detail',
  imports: [DatePipe, Icon, RouterLink],
  template: `
    <a class="back-link" routerLink="/medicines"><app-icon name="back" />All medicines</a>
    <!-- Read the detail request's state and retry through the same loader. -->
    @if (error()) {
      <div class="alert error" role="alert"><app-icon name="alert" /><div class="alert-body"><p>{{ error() }}</p>
        <div class="actions"><button type="button" class="secondary" (click)="load()"><app-icon name="retry" />Retry</button></div></div></div>
    }
    @if (busy()) {
      <p role="status" class="visually-hidden">Loading medicine…</p>
      <div class="card"><div class="card-body"><span class="skeleton w-lg"></span><br><span class="skeleton w-md"></span></div></div>
    }
    @if (medicine(); as item) {
      <div class="card">
        <div class="card-body hero">
          <div>
            <h1>{{ item.name }}</h1>
            <p class="meta">{{ item.code }} · {{ item.form }} · {{ item.strength_value }} {{ item.strength_unit }}</p>
            <span class="badge" [class.ok]="item.is_active" [class.off]="!item.is_active">{{ item.is_active ? 'Active' : 'Inactive — dispensing is unavailable' }}</span>
          </div>
          @if (item.is_active) { <a class="button" routerLink="/capture" [queryParams]="{ medicine: item.code }"><app-icon name="plus" />Capture this medicine</a> }
        </div>
        <!-- Summarise the rule in force now; the timeline below shows every version. -->
        @if (item.current_rule; as rule) {
          <div class="stats">
            <div class="stat"><span>Per dispense</span><strong>{{ rule.max_quantity_per_dispense }}</strong> <small>units</small></div>
            <div class="stat"><span>Per 30 days</span><strong>{{ rule.max_quantity_per_30_days }}</strong> <small>units</small></div>
            <div class="stat"><span>Authorisation</span><strong>{{ rule.requires_authorisation ? 'Required' : 'Not required' }}</strong></div>
          </div>
        } @else {
          <div class="stats"><div class="stat"><span>Current rule</span><strong>None in force</strong></div></div>
        }
      </div>
      <div class="card">
        <div class="card-header"><div><h2>Rule history</h2>
          <p>Dates and times are shown in Africa/Johannesburg. Each rule ends when the next period starts.</p></div></div>
        @if (!rules().length) { <div class="empty"><app-icon name="inbox" /><strong>No rules have been recorded.</strong></div> }
        <ol class="timeline">
          @for (rule of rules(); track rule.id) {
            <li [class.current]="rule.is_current" [class.future]="isScheduled(rule)">
              <div class="rule-card">
                <div class="rule-period">
                  {{ rule.effective_from | date:'d MMM yyyy':'+0200' }}
                  <span class="muted">→</span>
                  {{ rule.effective_to ? (rule.effective_to | date:'d MMM yyyy':'+0200') : 'open ended' }}
                  @if (rule.is_current) { <span class="badge live">In force now</span> }
                  @else if (isScheduled(rule)) { <span class="badge plain">Scheduled</span> }
                </div>
                <p class="rule-limits">
                  <span>Per dispense <b>{{ rule.max_quantity_per_dispense }}</b></span>
                  <span>Per 30 days <b>{{ rule.max_quantity_per_30_days }}</b></span>
                  <span>Authorisation <b>{{ rule.requires_authorisation ? 'required' : 'not required' }}</b></span>
                </p>
              </div>
            </li>
          }
        </ol>
      </div>
    }
  `,
})
export class ShowMedicine {
  // Follow the selected route and expose asynchronous state through signals.
  private readonly route = inject(ActivatedRoute);
  readonly medicine = signal<Medicine | null>(null);
  readonly rules = signal<Rule[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  private code = '';
  private controller?: AbortController;

  /** Reload whenever the route code changes; the router reuses this view across codes. */
  constructor() {
    // takeUntilDestroyed releases the subscription; DestroyRef aborts the in-flight reads.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(params => {
      this.code = params.get('code') ?? '';
      void this.load();
    });
    inject(DestroyRef).onDestroy(() => this.controller?.abort());
  }

  /** Fetch medicine details and complete history, with a recoverable error state. */
  async load(): Promise<void> {
    // Replace any in-flight read and clear the previous medicine so stale data is never shown.
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    this.error.set('');
    this.medicine.set(null);
    this.rules.set([]);
    const code = encodeURIComponent(this.code);
    try {
      // Independent endpoints can be read concurrently without sharing UI state.
      const [medicine, history] = await Promise.all([
        requestJson<Medicine>(`/medicines/${code}`, { signal: controller.signal }),
        requestJson<{ items: Rule[] }>(`/medicines/${code}/rules`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      this.medicine.set(medicine);
      this.rules.set(history.items);
    } catch (error) {
      // Ignore canceled requests while exposing genuine transport or API failures.
      if (!controller.signal.aborted) this.error.set(describeError(error));
    } finally {
      // A previous request cannot finish a more recent retry's loading state.
      if (this.controller === controller) this.busy.set(false);
    }
  }

  /** Mark versions that start after now, so the timeline separates past, current and scheduled rules. */
  isScheduled(rule: Rule): boolean {
    return new Date(rule.effective_from).getTime() > Date.now();
  }
}

import { DatePipe } from '@angular/common';
import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { describeError, Medicine, requestJson, Rule } from './api';

@Component({
  selector: 'app-medicine-detail',
  imports: [DatePipe, RouterLink],
  template: `
    <!-- Read the detail request's state and retry through the same loader. -->
    @if (error()) { <p role="alert" class="error">{{ error() }}</p><button (click)="load()">Retry</button> }
    @if (busy()) { <p role="status">Loading medicine…</p> }
    @if (medicine(); as item) {
      <h1>{{ item.name }}</h1>
      <p>{{ item.code }} · {{ item.form }} · {{ item.strength_value }} {{ item.strength_unit }}</p>
      <p>{{ item.is_active ? 'Active' : 'Inactive — dispensing is unavailable' }}</p>
      <a routerLink="/capture" [queryParams]="{ medicine: item.code }">Capture this medicine</a>
      <h2>Rule history</h2>
      <p>Dates and times are shown in Africa/Johannesburg. Each rule ends when the next period starts.</p>
      @if (!rules().length) { <p>No rules have been recorded.</p> }
      <ol class="timeline">
        @for (rule of rules(); track rule.id) {
          <li>
            <strong>{{ rule.effective_from | date:'yyyy-MM-dd HH:mm':'+0200' }}</strong>
            to {{ rule.effective_to ? (rule.effective_to | date:'yyyy-MM-dd HH:mm':'+0200') : 'open ended' }}
            @if (rule.is_current) { <strong> — <span>In force now</span></strong> }
            <p>Per dispense: {{ rule.max_quantity_per_dispense }} units. Per 30 days: {{ rule.max_quantity_per_30_days }} units.<br>
              Authorisation {{ rule.requires_authorisation ? 'required' : 'not required' }}.</p>
          </li>
        }
      </ol>
    }
  `,
})
export class ShowMedicine implements OnInit, OnDestroy {
  // Resolve the selected route and expose asynchronous state through signals.
  private readonly route = inject(ActivatedRoute);
  readonly medicine = signal<Medicine | null>(null);
  readonly rules = signal<Rule[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  private controller?: AbortController;

  /** Load the selected medicine and its timeline on entry. */
  ngOnInit(): void {
    // Start both independent reads together.
    void this.load();
  }

  /** Fetch medicine details and complete history, with a recoverable error state. */
  async load(): Promise<void> {
    // Replace any in-flight retry and clear stale error text.
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    this.error.set('');
    const code = encodeURIComponent(this.route.snapshot.paramMap.get('code') ?? '');
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

  /** Stop outstanding reads when leaving the detail view. */
  ngOnDestroy(): void {
    // Discard responses belonging to the old route.
    this.controller?.abort();
  }
}

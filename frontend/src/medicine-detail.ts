import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { describeError, Medicine, requestJson, Rule } from './api';

@Component({
  selector: 'app-medicine-detail',
  imports: [DatePipe, RouterLink],
  template: `
    <!-- Read the detail request's state and retry through the same loader. -->
    @if (error()) { <p role="alert" class="error">{{ error() }}</p><button type="button" (click)="load()">Retry</button> }
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
}

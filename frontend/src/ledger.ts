import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Dispense } from './api';
import { Icon } from './icon';
import { PageControls } from './page-controls';
import { Pager } from './pager';

@Component({
  selector: 'app-ledger',
  imports: [DatePipe, FormsModule, Icon, PageControls, RouterLink],
  template: `
    <div class="page-header"><div>
      <h1>Patient ledger</h1>
      <p>Every dispense for one patient reference, newest first. Times are shown in Africa/Johannesburg.</p>
    </div></div>
    <div class="card">
      <!-- Submit the opaque reference unchanged and start a fresh ledger traversal. -->
      <form class="card-body search-row" (ngSubmit)="search()" role="search">
        <label>Patient reference
          <span class="input-icon"><app-icon name="search" /><input name="patient" [(ngModel)]="patient" required maxlength="120" placeholder="e.g. patient-0000"></span>
        </label>
        <button type="submit" [disabled]="!patient()">Find dispenses</button>
      </form>
    </div>
    <!-- Read the current ledger request state. -->
    @if (searched()) {
      <div class="card">
        @if (pager.error()) { <div class="card-body"><p role="alert" class="alert error"><app-icon name="alert" />{{ pager.error() }}</p></div> }
        @if (pager.busy()) { <p role="status" class="visually-hidden">Loading dispenses…</p> }
        @if (!pager.busy() && !pager.error() && !pager.items().length) {
          <div class="empty"><app-icon name="inbox" /><strong>No dispenses found for this reference.</strong>References are matched exactly.</div>
        }
        @if (pager.busy() || pager.items().length) {
          <div class="table-wrap"><table>
            <thead><tr><th>Dispensed at</th><th>Medicine</th><th class="num">Quantity</th><th>Authorisation</th></tr></thead>
            <tbody>
              @if (pager.busy()) {
                @for (row of placeholders; track row) {
                  <tr><td><span class="skeleton w-md"></span></td><td><span class="skeleton w-sm"></span></td><td><span class="skeleton w-sm"></span></td><td><span class="skeleton w-sm"></span></td></tr>
                }
              } @else {
                @for (dispense of pager.items(); track dispense.id) {
                  <tr><td>{{ dispense.dispensed_at | date:'d MMM yyyy':'+0200' }}<span class="sub">{{ dispense.dispensed_at | date:'HH:mm':'+0200' }}</span></td>
                    <td><a class="code-link" [routerLink]="['/medicines', dispense.medicine_code]">{{ dispense.medicine_code }}</a></td>
                    <td class="num">{{ dispense.quantity }}</td>
                    <td>@if (dispense.authorisation_ref) { <span class="mono">{{ dispense.authorisation_ref }}</span> } @else { <span class="muted">None</span> }</td></tr>
                }
              }
            </tbody>
          </table></div>
        }
        <app-page-controls [pager]="pager" />
      </div>
    } @else {
      <div class="card"><div class="empty"><app-icon name="ledger" /><strong>Enter a patient reference</strong>The ledger lists that patient's dispenses across every medicine.</div></div>
    }
  `,
})
export class ShowLedger {
  // The URL query parameter is the single source of truth for the selected patient.
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly patient = signal('');
  readonly searched = signal(false);
  readonly pager = new Pager<Dispense>('/dispenses');
  // Fixed skeleton rows shown while a page loads, so the layout does not jump.
  readonly placeholders = [1, 2, 3, 4, 5, 6];

  /** Follow the patient query parameter, including reloads, history and the main navigation link. */
  constructor() {
    // takeUntilDestroyed releases the subscription with the view.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(params => {
      this.patient.set(params.get('patient') ?? '');
      void this.loadLedger();
    });
  }

  /** Record the entered reference in the URL; the subscription performs the load. */
  async search(): Promise<void> {
    const patient = this.patient();
    if (!patient) return;
    // Navigating to the same URL is ignored by the router, so refresh the same patient directly.
    if (patient === this.route.snapshot.queryParamMap.get('patient')) return this.loadLedger();
    await this.router.navigate([], { queryParams: { patient } });
  }

  /** Load the first page for exactly the selected reference, or clear the view when none is selected. */
  private async loadLedger(): Promise<void> {
    const patient = this.patient();
    this.searched.set(!!patient);
    // Avoid listing unrelated patients when the reference is empty.
    if (!patient) return this.pager.clear();
    // Reset cursor scope whenever the patient changes.
    await this.pager.search({ patient_ref: patient });
  }
}

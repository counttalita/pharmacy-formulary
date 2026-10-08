import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Dispense } from './api';
import { PageControls } from './page-controls';
import { Pager } from './pager';

@Component({
  selector: 'app-ledger',
  imports: [DatePipe, FormsModule, PageControls],
  template: `
    <h1>Patient ledger</h1>
    <!-- Submit the opaque reference unchanged and start a fresh ledger traversal. -->
    <form (ngSubmit)="search()">
      <label>Patient reference<input name="patient" [(ngModel)]="patient" required maxlength="120"></label>
      <button type="submit" [disabled]="!patient()">Find dispenses</button>
    </form>
    <!-- Read the current ledger request state. -->
    @if (pager.busy()) { <p role="status">Loading dispenses…</p> }
    @if (pager.error()) { <p role="alert" class="error">{{ pager.error() }}</p> }
    @if (searched() && !pager.busy() && !pager.error() && !pager.items().length) { <p>No dispenses found for this reference.</p> }
    @if (pager.items().length) {
      <p>Newest first. Times are shown in Africa/Johannesburg.</p>
      <table><thead><tr><th>Dispensed at</th><th>Medicine</th><th>Quantity</th><th>Authorisation</th></tr></thead>
        <tbody>@for (dispense of pager.items(); track dispense.id) {
          <tr><td>{{ dispense.dispensed_at | date:'yyyy-MM-dd HH:mm':'+0200' }}</td><td>{{ dispense.medicine_code }}</td>
            <td>{{ dispense.quantity }}</td><td>{{ dispense.authorisation_ref || 'None' }}</td></tr>
        }</tbody>
      </table>
    }
    <app-page-controls [pager]="pager" />
  `,
})
export class ShowLedger {
  // The URL query parameter is the single source of truth for the selected patient.
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly patient = signal('');
  readonly searched = signal(false);
  readonly pager = new Pager<Dispense>('/dispenses');

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

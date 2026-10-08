import { DatePipe } from '@angular/common';
import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
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
      <button type="submit" [disabled]="!patient">Find dispenses</button>
    </form>
    <!-- Read the current ledger request state. -->
    @if (pager.busy()) { <p role="status">Loading dispenses…</p> }
    @if (pager.error()) { <p role="alert" class="error">{{ pager.error() }}</p> }
    @if (searched && !pager.busy() && !pager.error() && !pager.items().length) { <p>No dispenses found for this reference.</p> }
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
export class ShowLedger implements OnInit, OnDestroy {
  // Preselect the reference when arriving from a successful capture.
  private readonly route = inject(ActivatedRoute);
  patient = this.route.snapshot.queryParamMap.get('patient') ?? '';
  searched = false;
  readonly pager = new Pager<Dispense>('/dispenses');

  /** Load a linked patient's ledger without requiring another form submission. */
  ngOnInit(): void {
    // Avoid listing unrelated patients when the reference is empty.
    if (this.patient) void this.search();
  }

  /** Load the first page for exactly the entered reference. */
  async search(): Promise<void> {
    if (!this.patient) return;
    this.searched = true;
    // Reset cursor scope whenever the patient changes.
    await this.pager.search({ patient_ref: this.patient });
  }

  /** Cancel ledger reads when the user navigates away. */
  ngOnDestroy(): void {
    // Stop stale results from updating a destroyed component.
    this.pager.cancel();
  }
}

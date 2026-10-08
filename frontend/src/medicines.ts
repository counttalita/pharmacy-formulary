import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Medicine } from './api';
import { Pager } from './pager';
import { PageControls } from './page-controls';

@Component({
  selector: 'app-medicines',
  imports: [FormsModule, RouterLink, PageControls],
  template: `
    <h1>Medicines</h1>
    <!-- Submit a fresh search and reset its pagination state. -->
    <form (ngSubmit)="search()">
      <label>Search medicines<input name="search" [(ngModel)]="query" placeholder="Partial name or code" maxlength="200"></label>
      <button type="submit">Search</button>
    </form>
    <!-- Read the current request's loading, error and result signals. -->
    @if (pager.busy()) { <p role="status">Loading medicines…</p> }
    @if (pager.error()) { <p role="alert" class="error">{{ pager.error() }}</p> }
    @if (!pager.busy() && !pager.error() && !pager.items().length) { <p>No medicines found.</p> }
    @if (pager.items().length) {
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Form</th><th>Strength</th><th>Status</th></tr></thead>
        <tbody>
          @for (medicine of pager.items(); track medicine.code) {
            <tr><td><a [routerLink]="['/medicines', medicine.code]">{{ medicine.code }}</a></td>
              <td>{{ medicine.name }}</td><td>{{ medicine.form }}</td>
              <td>{{ medicine.strength_value }} {{ medicine.strength_unit }}</td>
              <td>{{ medicine.is_active ? 'Active' : 'Inactive' }}</td></tr>
          }
        </tbody>
      </table>
    }
    <app-page-controls [pager]="pager" />
  `,
})
export class SearchMedicines implements OnInit {
  query = '';
  // Keep catalogue pagination scoped to this view; the pager cancels itself on destroy.
  readonly pager = new Pager<Medicine>('/medicines');

  /** Load the initial catalogue page. */
  ngOnInit(): void {
    // Reuse the same path as user-initiated searches.
    void this.search();
  }

  /** Search literal name/code text and return to the first page. */
  async search(): Promise<void> {
    // The pager discards stale requests if the user searches again.
    await this.pager.search({ q: this.query });
  }
}

import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Medicine } from './api';
import { Icon } from './icon';
import { Pager } from './pager';
import { PageControls } from './page-controls';

@Component({
  selector: 'app-medicines',
  imports: [FormsModule, Icon, RouterLink, PageControls],
  template: `
    <div class="page-header"><div>
      <h1>Medicines</h1>
      <p>Search the catalogue by partial name or code, then open a medicine to see its rule history.</p>
    </div></div>
    <div class="card">
      <!-- Submit a fresh search and reset its pagination state. -->
      <form class="card-body search-row" (ngSubmit)="search()" role="search">
        <label>Search medicines
          <span class="input-icon"><app-icon name="search" /><input name="search" [(ngModel)]="query" placeholder="e.g. Generated or SEED-0042" maxlength="200"></span>
        </label>
        <button type="submit">Search</button>
      </form>
    </div>
    <div class="card">
      <!-- Read the current request's loading, error and result signals. -->
      @if (pager.error()) { <div class="card-body"><p role="alert" class="alert error"><app-icon name="alert" />{{ pager.error() }}</p></div> }
      @if (pager.busy()) { <p role="status" class="visually-hidden">Loading medicines…</p> }
      @if (!pager.busy() && !pager.error() && !pager.items().length) {
        <div class="empty"><app-icon name="inbox" /><strong>No medicines found</strong>Try a shorter name or code fragment.</div>
      }
      @if (pager.busy() || pager.items().length) {
        <div class="table-wrap"><table>
          <thead><tr><th>Code</th><th>Name</th><th>Form</th><th class="num">Strength</th><th>Status</th></tr></thead>
          <tbody>
            @if (pager.busy()) {
              @for (row of placeholders; track row) {
                <tr><td><span class="skeleton w-sm"></span></td><td><span class="skeleton w-lg"></span></td><td><span class="skeleton w-sm"></span></td><td><span class="skeleton w-sm"></span></td><td><span class="skeleton w-sm"></span></td></tr>
              }
            } @else {
              @for (medicine of pager.items(); track medicine.code) {
                <tr><td><a class="code-link" [routerLink]="['/medicines', medicine.code]">{{ medicine.code }}</a></td>
                  <td>{{ medicine.name }}</td><td class="muted">{{ medicine.form }}</td>
                  <td class="num">{{ medicine.strength_value }} {{ medicine.strength_unit }}</td>
                  <td><span class="badge" [class.ok]="medicine.is_active" [class.off]="!medicine.is_active">{{ medicine.is_active ? 'Active' : 'Inactive' }}</span></td></tr>
              }
            }
          </tbody>
        </table></div>
      }
      <app-page-controls [pager]="pager" />
    </div>
  `,
})
export class SearchMedicines implements OnInit {
  query = '';
  // Fixed skeleton rows shown while a page loads, so the layout does not jump.
  readonly placeholders = [1, 2, 3, 4, 5, 6];
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

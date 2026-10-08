import { Component, input } from '@angular/core';

interface Navigation {
  busy(): boolean;
  pageNumber(): number;
  nextCursor(): string | null;
  next(): Promise<void>;
  previous(): Promise<void>;
  error(): string;
  retry(): Promise<void>;
}

@Component({
  selector: 'app-page-controls',
  template: `
    <!-- Read pagination state and invoke the listing's navigation methods. -->
    @if (pager().error()) { <button type="button" (click)="pager().retry()">Retry</button> }
    <button type="button" (click)="pager().previous()" [disabled]="pager().busy() || pager().pageNumber() === 1">Previous page</button>
    <span>Page {{ pager().pageNumber() }}</span>
    <button type="button" (click)="pager().next()" [disabled]="pager().busy() || !pager().nextCursor()">Next page</button>
  `,
})
export class PageControls {
  // Require the owning view's navigation state.
  readonly pager = input.required<Navigation>();
}

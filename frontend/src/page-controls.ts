import { Component, input } from '@angular/core';
import { Icon } from './icon';

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
  imports: [Icon],
  template: `
    <!-- Read pagination state and invoke the listing's navigation methods. -->
    <div class="pager">
      <span class="pager-page">Page {{ pager().pageNumber() }}</span>
      <div class="pager-controls">
        @if (pager().error()) { <button type="button" class="secondary" (click)="pager().retry()"><app-icon name="retry" />Retry</button> }
        <button type="button" class="secondary" (click)="pager().previous()" [disabled]="pager().busy() || pager().pageNumber() === 1"><app-icon name="left" />Previous page</button>
        <button type="button" class="secondary" (click)="pager().next()" [disabled]="pager().busy() || !pager().nextCursor()">Next page<app-icon name="right" /></button>
      </div>
    </div>
  `,
})
export class PageControls {
  // Require the owning view's navigation state.
  readonly pager = input.required<Navigation>();
}

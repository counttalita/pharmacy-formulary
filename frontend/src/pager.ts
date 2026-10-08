import { DestroyRef, inject, signal } from '@angular/core';
import { describeError, Page, requestJson } from './api';

export class Pager<T> {
  // Signals expose asynchronous state to Angular's zoneless change detection.
  readonly items = signal<T[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly nextCursor = signal<string | null>(null);
  readonly pageNumber = signal(1);
  private controller?: AbortController;
  private cursors: (string | null)[] = [null];
  private query = '';

  /** Bind one listing endpoint to its owning view; must be created in an injection context. */
  constructor(private endpoint: string) {
    // Abort the in-flight fetch when the owning view is destroyed so nothing retains it.
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  /** Reset pagination whenever the user submits different search criteria. */
  async search(parameters: Record<string, string>): Promise<void> {
    // A fresh search never reuses a token belonging to previous filters.
    this.query = new URLSearchParams(parameters).toString();
    this.cursors = [null];
    this.pageNumber.set(1);
    await this.load();
  }

  /** Advance only when the server returned a continuation token. */
  async next(): Promise<void> {
    // Store visited cursors so previous-page navigation needs no offset query.
    const next = this.nextCursor();
    if (this.busy() || !next) return;
    this.cursors.push(next);
    this.pageNumber.set(this.cursors.length);
    await this.load();
  }

  /** Revisit the preceding cursor while preserving the current filters. */
  async previous(): Promise<void> {
    // Retain the first-page sentinel instead of generating an empty cursor.
    if (this.busy() || this.cursors.length === 1) return;
    this.cursors.pop();
    this.pageNumber.set(this.cursors.length);
    await this.load();
  }

  /** Repeat the current page request after a failure, keeping filters and position. */
  async retry(): Promise<void> {
    // Reuse the same cursor rather than restarting from the first page.
    if (this.busy()) return;
    await this.load();
  }

  /** Discard results and pagination when the view has no criteria to list. */
  clear(): void {
    // Cancel first so a late response cannot repopulate the cleared view.
    this.cancel();
    this.cursors = [null];
    this.pageNumber.set(1);
    this.items.set([]);
    this.nextCursor.set(null);
    this.error.set('');
    this.busy.set(false);
  }

  /** Abort the in-flight request, if any. */
  cancel(): void {
    // Avoid stale updates after navigation.
    this.controller?.abort();
  }

  /** Replace results only if this is still the most recent request. */
  private async load(): Promise<void> {
    // Abort the previous fetch and guard against already-resolved responses too.
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    this.busy.set(true);
    this.error.set('');
    this.items.set([]);
    this.nextCursor.set(null);
    const cursor = this.cursors.at(-1);
    const parameters = new URLSearchParams(this.query);
    parameters.set('limit', '20');
    if (cursor) parameters.set('cursor', cursor);
    try {
      // Fetch one page with the original filter scope.
      const page = await requestJson<Page<T>>(`${this.endpoint}?${parameters}`, { signal: controller.signal });
      if (this.controller !== controller) return;
      this.items.set(page.items);
      this.nextCursor.set(page.next_cursor);
    } catch (error) {
      // Canceled searches must not overwrite errors or results from newer ones.
      if (!controller.signal.aborted) this.error.set(describeError(error));
    } finally {
      // Only the active request can finish the loading state.
      if (this.controller === controller) this.busy.set(false);
    }
  }
}

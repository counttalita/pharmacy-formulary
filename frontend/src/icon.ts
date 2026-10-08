import { Component, computed, input } from '@angular/core';

// Stroke paths for the few icons the views use; decorative only.
const PATHS: Record<string, string> = {
  pill: 'M10.5 20.5 3.5 13.5a4.95 4.95 0 1 1 7-7l7 7a4.95 4.95 0 1 1-7 7Z M8.5 8.5l7 7',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z M21 21l-4.3-4.3',
  clipboard: 'M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2 M9 13l2 2 4-4',
  ledger: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2Z M8 7h6 M8 11h6 M8 15h4',
  back: 'M15 18l-6-6 6-6',
  alert: 'M12 9v4 M12 17h.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  check: 'M22 11.1V12a10 10 0 1 1-5.9-9.1 M22 4 12 14l-3-3',
  retry: 'M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5',
  plus: 'M12 5v14 M5 12h14',
  left: 'M15 18l-6-6 6-6',
  right: 'M9 18l6-6-6-6',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6Z',
};

@Component({
  selector: 'app-icon',
  host: { 'aria-hidden': 'true', style: 'display: contents' },
  template: `
    <!-- Render one decorative stroke icon at the surrounding text size. -->
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path [attr.d]="path()" />
    </svg>
  `,
})
export class Icon {
  // Resolve the requested icon name to its path data.
  readonly name = input.required<string>();
  readonly path = computed(() => PATHS[this.name()] ?? '');
}

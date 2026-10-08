import { Component, computed, input } from '@angular/core';
import { ApiIssue } from './api';

@Component({
  selector: 'app-field-errors',
  template: `
    <!-- Render every matching error rather than selecting only the first. -->
    <ul class="error" [id]="field() + '-errors'">
      @for (issue of matching(); track $index) { <li>{{ issue.message }}</li> }
    </ul>
  `,
})
export class FieldErrors {
  // Bind errors to the corresponding form control without duplicating messages.
  readonly field = input.required<string>();
  readonly issues = input.required<ApiIssue[]>();
  readonly matching = computed(() => this.issues().filter(issue => issue.field === this.field()));
}

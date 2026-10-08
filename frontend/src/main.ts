import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, RouterLink, RouterOutlet } from '@angular/router';
import { CaptureDispense } from './capture';
import { ShowLedger } from './ledger';
import { ShowMedicine } from './medicine-detail';
import { SearchMedicines } from './medicines';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  template: `
    <nav aria-label="Main navigation"><a routerLink="/medicines">Medicines</a><a routerLink="/capture">Capture dispense</a><a routerLink="/ledger">Patient ledger</a></nav>
    <main><router-outlet /></main>
  `,
})
class App {}

// Bootstrap four standalone views with route-based navigation.
bootstrapApplication(App, { providers: [provideRouter([
  { path: 'medicines', component: SearchMedicines },
  { path: 'medicines/:code', component: ShowMedicine },
  { path: 'capture', component: CaptureDispense },
  { path: 'ledger', component: ShowLedger },
  { path: '**', redirectTo: 'medicines' },
])] }).catch(console.error);

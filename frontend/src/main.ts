import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { CaptureDispense } from './capture';
import { Icon } from './icon';
import { ShowLedger } from './ledger';
import { ShowMedicine } from './medicine-detail';
import { SearchMedicines } from './medicines';

@Component({
  selector: 'app-root',
  imports: [Icon, RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <!-- Shared shell around the four views; the active link follows the current route. -->
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" routerLink="/medicines"><span class="brand-mark"><app-icon name="pill" /></span>
        <span>Formulary</span></a>
      <nav aria-label="Main navigation">
        <a routerLink="/medicines" routerLinkActive="active"><app-icon name="search" />Medicines</a>
        <a routerLink="/capture" routerLinkActive="active"><app-icon name="clipboard" />Capture dispense</a>
        <a routerLink="/ledger" routerLinkActive="active"><app-icon name="ledger" />Patient ledger</a>
      </nav>
    </div></header>
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

import { StateRegistry } from '#/_base/state/stateRegistry';
import { IAppStateService } from '#/app/state/appState';

import type { IProjectStateService } from './projectState';

export class WorkspaceStateService extends StateRegistry implements IProjectStateService {
  declare readonly _serviceBrand: undefined;
  protected override readonly inspectScope = 'workspace';

  constructor(@IAppStateService appState?: IAppStateService) {
    super();
    this.inspectParent = appState;
  }
}

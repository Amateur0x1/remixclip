import { getPlatformInfo } from '@remixclip/platform';

export class SidecarFactory {
  static create(): SidecarFactory {
    return new SidecarFactory();
  }

  getPlatform(): string {
    return getPlatformInfo().os;
  }
}

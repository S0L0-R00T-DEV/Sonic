import type { SonicApi } from './index'

declare global {
  interface Window {
    sonic: SonicApi
  }
}

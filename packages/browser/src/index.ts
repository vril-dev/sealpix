import { SealpixCaptureElement } from './capture-element.ts'
import { SealpixViewerElement } from './viewer-element.ts'

export { SealpixCaptureElement, type CaptureCompleteDetail } from './capture-element.ts'
export { SealpixViewerElement, type DecryptedView } from './viewer-element.ts'
export { cropRegion, paintRegions, sealTemplate, sealWhole, type SealResult } from './seal-image.ts'
export { DEFAULT_OPENCV_INTEGRITY, DEFAULT_OPENCV_SRC, loadOpenCv } from './opencv.ts'

if (!customElements.get('sealpix-capture')) {
  customElements.define('sealpix-capture', SealpixCaptureElement)
}
if (!customElements.get('sealpix-viewer')) {
  customElements.define('sealpix-viewer', SealpixViewerElement)
}

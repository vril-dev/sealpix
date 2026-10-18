// OpenCV.js の読み込み。
// OpenCV.js の本体（Module オブジェクト）は then メソッドを持つため、Promise の値として返すと
// then が繰り返し呼ばれて処理が終わらなくなる。読み込みの完了だけを待ち、本体は getOpenCv() で取り出す。

export const DEFAULT_OPENCV_SRC =
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js'
export const DEFAULT_OPENCV_INTEGRITY =
  'sha384-XsTfGA62I8LzqS3D7IcgiSOCrJuECWLcg4s1M0AnrkDCcJ8lXX+j+qdg+o6t7KZa'

const TIMEOUT_MS = 60_000
const POLL_MS = 100

// OpenCV.js には型定義がないため、使う側で必要な関数だけを呼ぶ
export type OpenCv = any

interface OpenCvWindow {
  cv?: OpenCv
}

let loading: Promise<void> | null = null

export function loadOpenCv(
  src: string = DEFAULT_OPENCV_SRC,
  integrity: string | null = DEFAULT_OPENCV_INTEGRITY,
): Promise<void> {
  if (loading !== null) return loading
  const w = window as unknown as OpenCvWindow
  loading = new Promise<void>((resolve, reject) => {
    if (w.cv === undefined) {
      const script = document.createElement('script')
      script.src = src
      script.async = true
      script.crossOrigin = 'anonymous'
      if (integrity !== null) script.integrity = integrity
      script.onerror = () => reject(new Error('OpenCV.js を読み込めませんでした'))
      document.head.appendChild(script)
    }
    const started = Date.now()
    const poll = () => {
      if (w.cv?.Mat !== undefined) resolve()
      else if (Date.now() - started > TIMEOUT_MS) {
        reject(new Error('OpenCV.js の初期化が時間内に終わりませんでした'))
      } else setTimeout(poll, POLL_MS)
    }
    poll()
  })
  // 失敗したときは、次の呼び出しで読み込みをやり直せるようにする
  loading.catch(() => {
    loading = null
  })
  return loading
}

export function getOpenCv(): OpenCv {
  const cv = (window as unknown as OpenCvWindow).cv
  if (cv?.Mat === undefined) throw new Error('OpenCV.js が読み込まれていません')
  return cv
}

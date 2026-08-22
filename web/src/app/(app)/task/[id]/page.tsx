// URL 初期化は TaskPanesProvider（pathname 監視）が担うため、ページ本体は
// TaskPanesHost 経由で描画される。SSR 分は dynamic loading 表示で埋まる。
export default function TaskPage() {
  return null;
}

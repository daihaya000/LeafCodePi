import { HomeView } from "@/components/home/HomeView";
import { BotListView } from "@/components/bot/BotListView";
import { BotView } from "@/components/bot/BotView";
import { RoomView } from "@/components/bot/RoomView";
import { MainLayoutClient } from "@/components/shell/MainLayoutClient";
import { routeParams, usePathname, useSearchParams } from "./navigation";

export default function ProtectedApp() {
  const pathname = usePathname(), query = useSearchParams(), params = routeParams(pathname);
  let page;
  if (pathname === "/") {
    const projectId = query.get("projectId") ?? undefined, noProject = query.get("noProject") === "1";
    page = <HomeView key={`${projectId ?? ""}:${noProject ? "no-project" : "project"}`} initialProjectId={projectId} initialNoProject={noProject} />;
  } else if (pathname === "/settings" || pathname.startsWith("/task/") && params.id) page = null;
  else if (pathname === "/bots") page = <BotListView />;
  else if (params.roomId) page = <RoomView id={params.roomId} />;
  else if (pathname.startsWith("/bots/") && params.id) page = <BotView id={params.id} />;
  else page = <main className="p-6 text-muted">ページが見つかりません。</main>;
  return <MainLayoutClient>{page}</MainLayoutClient>;
}

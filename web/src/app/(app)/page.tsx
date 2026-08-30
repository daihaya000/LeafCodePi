import { HomeView } from "@/components/home/HomeView";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    projectId?: string | string[];
    noProject?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  const noProject = query.noProject === "1";
  return (
    <HomeView
      key={`${projectId ?? ""}:${noProject ? "no-project" : "project"}`}
      initialProjectId={projectId}
      initialNoProject={noProject}
    />
  );
}

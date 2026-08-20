import { HomeView } from "@/components/home/HomeView";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string | string[] }>;
}) {
  const query = await searchParams;
  const projectId = typeof query.projectId === "string" ? query.projectId : undefined;
  return <HomeView key={projectId} initialProjectId={projectId} />;
}

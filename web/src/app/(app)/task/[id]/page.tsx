import { TaskView } from "@/components/task/TaskView";

export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TaskView taskId={id} />;
}

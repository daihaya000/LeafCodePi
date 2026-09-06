import { BotView } from "@/components/bot/BotView";
export default async function BotPage({ params }: { params: Promise<{ id: string }> }) { return <BotView id={(await params).id} />; }

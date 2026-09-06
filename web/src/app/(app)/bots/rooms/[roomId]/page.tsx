import { RoomView } from "@/components/bot/RoomView";
export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) { return <RoomView id={(await params).roomId} />; }
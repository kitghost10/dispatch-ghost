import { PageHeader } from "@/components/PageHeader";
import { Simulator } from "./Simulator";

export default async function SimulatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PageHeader eyebrow="REHEARSE BEFORE GOING LIVE" title="Test the receptionist" description="Try real customer scenarios and fine-tune the experience."/>
      <Simulator tenantId={id} />
    </>
  );
}

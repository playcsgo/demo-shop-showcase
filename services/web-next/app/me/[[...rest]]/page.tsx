import { MemberPage } from '@/ui/pages/MemberPage.tsx'
import { ClientOnly } from '@/ui/shell.tsx'

export default function Page() {
  return <ClientOnly><MemberPage /></ClientOnly>
}

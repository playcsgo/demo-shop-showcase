import { LoginPage } from '@/ui/pages/LoginPage.tsx'
import { ClientOnly } from '@/ui/shell.tsx'

export default function Page() {
  return <ClientOnly><LoginPage /></ClientOnly>
}

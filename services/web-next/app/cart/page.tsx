import { CartPage } from '@/ui/pages/CartPage.tsx'
import { ClientOnly } from '@/ui/shell.tsx'

export default function Page() {
  return <ClientOnly><CartPage /></ClientOnly>
}

import { SyntheticAssistant } from '@/components/SyntheticAssistant';
import { usePageTitle } from '@/hooks/usePageTitle';

export default function LocalInterpretationPage() {
  usePageTitle('PGx explanation preview');
  return <SyntheticAssistant />;
}

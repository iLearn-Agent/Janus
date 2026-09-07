import { Redirect } from 'expo-router';
import { useConnectionStore } from '@/stores/connectionStore';

export default function Index() {
  const connected = useConnectionStore((state) => state.connected);
  return <Redirect href={connected ? '/(tabs)/home' : '/connect'} />;
}

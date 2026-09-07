import { Stack } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';

const queryClient = new QueryClient();

export default function RootLayout() {
  return <QueryClientProvider client={queryClient}><StatusBar style="auto" /><Stack screenOptions={{ headerShown: false }} /></QueryClientProvider>;
}

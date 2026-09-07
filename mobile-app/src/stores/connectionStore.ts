import { create } from 'zustand';
type State = { connected: boolean; baseUrl: string; token: string; pair: (baseUrl: string, code: string) => void; clear: () => void };
export const useConnectionStore = create<State>((set) => ({ connected: false, baseUrl: '', token: '', pair: (baseUrl, code) => set({ connected: true, baseUrl, token: `mock-token-${code}` }), clear: () => set({ connected: false, baseUrl: '', token: '' }) }));

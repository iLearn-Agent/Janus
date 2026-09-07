export type GatewaySession = { id: string; title: string; departmentId?: string; agentId?: string; updatedAt?: string };
export type GatewayMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt?: string };
export type GatewayClient = { listSessions(): Promise<GatewaySession[]>; createSession(): Promise<GatewaySession>; listMessages(id: string): Promise<GatewayMessage[]>; sendChat(id: string, instruction: string): Promise<{ id: string }> };

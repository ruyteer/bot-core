export interface FunnelNode {
  id:        string;
  funnelId:  string;
  type:      string;
  content:   Record<string, unknown>;
  positionX: number;
  positionY: number;
}

export interface NodeConnection {
  id:           string;
  funnelId:     string;
  sourceNodeId: string;
  sourceHandle: string | null;
  targetNodeId: string;
}

export interface Funnel {
  id:               string;
  userId:           string;
  botId:            string | null;
  name:             string;
  kind:             string;
  isActive:         boolean;
  simplifiedConfig: Record<string, unknown>;
  createdAt:        Date;
  updatedAt:        Date;
}

export interface FunnelWithBots extends Funnel {
  bots: { id: string; name: string }[];
}

export interface FunnelDetail extends FunnelWithBots {
  nodes:       FunnelNode[];
  connections: NodeConnection[];
}

export interface CreateFunnelInput {
  userId: string;
  botId:  string;
  name:   string;
  kind:   string;
}

export interface SaveFlowInput {
  nodes: Array<{
    id:        string;
    type:      string;
    content:   Record<string, unknown>;
    positionX: number;
    positionY: number;
  }>;
  connections: Array<{
    id:           string;
    sourceNodeId: string;
    sourceHandle: string | null;
    targetNodeId: string;
  }>;
}

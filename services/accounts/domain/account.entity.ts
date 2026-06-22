export interface Account {
  id:        string;
  email:     string;
  name:      string;
  apiKey:    string;
  createdAt: Date;
}

export interface CreateAccountInput {
  email: string;
  name:  string;
}

export interface Profile {
  id:        string;  // = Supabase auth UUID
  email:     string;
  name:      string;
  isBlocked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileWithRoles extends Profile {
  roles: string[];
  isAdmin: boolean;
}

export interface UpsertProfileInput {
  id:    string;
  email: string;
  name:  string;
}

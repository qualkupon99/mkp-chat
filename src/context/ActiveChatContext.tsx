import React, { createContext, useContext, useState } from 'react';
import type { Profile } from '../lib/supabase';

type ActiveChatContextType = {
  activePartner: Profile | null;
  setActivePartner: (profile: Profile | null) => void;
};

const ActiveChatContext = createContext<ActiveChatContextType>({
  activePartner: null,
  setActivePartner: () => {},
});

export const ActiveChatProvider = ({ children }: { children: React.ReactNode }) => {
  const [activePartner, setActivePartner] = useState<Profile | null>(null);

  return (
    <ActiveChatContext.Provider value={{ activePartner, setActivePartner }}>
      {children}
    </ActiveChatContext.Provider>
  );
};

export const useActiveChat = () => useContext(ActiveChatContext);

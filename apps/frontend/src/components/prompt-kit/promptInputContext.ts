// Adapted from Prompt Kit; see README.md and LICENSE.md.
import { createContext, useContext } from 'react';

export const PromptInputContext = createContext({
  value: '',
  setValue: (_value: string) => {
    void _value;
  },
  isLoading: false,
  disabled: false,
  onSubmit: () => {},
});
export const usePromptInput = () => useContext(PromptInputContext);

import { createContext } from "react";
export const FormFieldContext = createContext<{ name: string } | null>(null);
export const FormItemContext = createContext<{ id: string } | null>(null);

import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-11 w-full rounded-lg border border-white/12 bg-[#0c1014] px-3 text-sm text-[#e8edf2] outline-none transition placeholder:text-[#6d7886] focus:border-[#e0b15a]",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition duration-200 ease-out disabled:pointer-events-none disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7FD4E8]",
  {
    variants: {
      variant: {
        default: "bg-[linear-gradient(180deg,#F5D58A_0%,#C9A24B_58%,#8C6A2B_140%)] text-[#1A1408] shadow-[inset_0_1px_0_rgba(255,248,230,0.55)] hover:brightness-110",
        gold: "bg-[linear-gradient(180deg,#F5D58A_0%,#C9A24B_58%,#8C6A2B_140%)] text-[#1A1408] shadow-[inset_0_1px_0_rgba(255,248,230,0.55)] hover:brightness-110",
        ghost: "bg-transparent text-inherit hover:bg-white/10",
        desk: "bg-[linear-gradient(180deg,#F5D58A_0%,#C9A24B_58%,#8C6A2B_140%)] text-[#1A1408] shadow-[inset_0_1px_0_rgba(255,248,230,0.55)] hover:brightness-110",
        danger: "bg-[#FF5D6C] text-[#2A0709] hover:brightness-110",
        outline: "border border-[rgba(245,213,138,0.35)] bg-transparent text-inherit hover:bg-[rgba(245,213,138,0.08)]",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-xs",
        lg: "h-12 px-6",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

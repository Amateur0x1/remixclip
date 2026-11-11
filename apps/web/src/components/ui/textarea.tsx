/**
 * [INPUT]: Native textarea props and the shared neutral form tokens.
 * [OUTPUT]: Textarea with a quiet border-only focus state, without an outer ring.
 * [POS]: Shared shadcn multiline field for chat and profile prompts.
 */
import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-gray-500 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive md:text-sm ",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }

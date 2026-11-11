/** Incrementing generation cancels stale async results without relying on transport abort. */
export function createRequestGeneration(){let version=0;return {next:()=>++version,current:()=>version,isCurrent:value=>value===version}}

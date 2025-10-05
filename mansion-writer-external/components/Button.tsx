import React from "react";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  color?: "black" | "orange";
  className?: string;
};

export function Button({ color = "black", className = "", ...props }: Props) {
  const base = "btn " + (color === "orange" ? "btn-orange" : "btn-black");
  return <button {...props} className={[base, className].join(" ")} />;
}

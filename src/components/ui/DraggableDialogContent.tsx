import * as Dialog from "@radix-ui/react-dialog";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type ComponentPropsWithoutRef,
} from "react";

import { useDialogDrag } from "@/hooks/useDialogDrag";

type Props = ComponentPropsWithoutRef<typeof Dialog.Content>;

/**
 * Drop-in replacement for {@link Dialog.Content} that lets the user drag the
 * dialog around by its header area (top 72 px). Interactive descendants
 * (buttons, inputs, tabs) keep working because we skip drag initiation when
 * the mousedown target is inside one of them.
 *
 * Keep the existing Tailwind classes on the element — notably
 * `-translate-x-1/2 -translate-y-1/2`. They still center the dialog initially;
 * we just override the transform via inline style to add the drag offset.
 */
export const DraggableDialogContent = forwardRef<HTMLDivElement, Props>(
  function DraggableDialogContent({ style, children, ...rest }, forwardedRef) {
    const innerRef = useRef<HTMLDivElement | null>(null);
    useImperativeHandle(forwardedRef, () => innerRef.current as HTMLDivElement);
    const { style: dragStyle } = useDialogDrag(innerRef);

    return (
      <Dialog.Content
        {...rest}
        ref={innerRef}
        style={{ ...style, ...dragStyle }}
      >
        {children}
      </Dialog.Content>
    );
  },
);

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, EmptyState } from "@denicheur-breizh/design-system";
import styles from "../App.module.css";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
  message: string;
  resetKey: string;
  retryLabel: string;
}

interface WorkspaceErrorBoundaryState {
  failed: boolean;
}

export class WorkspaceErrorBoundary extends Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  state: WorkspaceErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): WorkspaceErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: WorkspaceErrorBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Workspace view failed to render", error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <EmptyState className={styles.errorState} role="alert">
        <p>{this.props.message}</p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          {this.props.retryLabel}
        </Button>
      </EmptyState>
    );
  }
}

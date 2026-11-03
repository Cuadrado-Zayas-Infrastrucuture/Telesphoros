# Skeleton loading review

Local component-harness captures, using the application's actual Skeleton, ContentSkeleton, PatientPicker and ChatLoading components with synthetic labels. These are layout reviews, not screenshots of live patient data or a deployed application.

- desktop.png: detail, list and compact skeletons plus patient selection.
- mobile.png: the same components at 390px with reduced motion.
- mobile-dark.png: dark tokens with the normal sweep animation.
- chat-mobile.png: report-upload chat skeleton at 390px with reduced motion.

Reviewed at 320, 390 and 1440px without horizontal overflow. Automated axe checks reported zero violations for the shared layout review and chat review. Reduced-motion computed styles contain the one-time appearance animation only, with no shimmer. The temporary review HTML/TSX files were removed; they are not deployed.

import { createBrowserRouter } from "react-router-dom";

import LoginPage from "@/pages/LoginPage";
import VideoDetailPage from "@/pages/VideoDetailPage";
import VideosPage from "@/pages/VideosPage";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/videos", element: <VideosPage /> },
  { path: "/videos/:id", element: <VideoDetailPage /> },
]);
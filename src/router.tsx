import { createBrowserRouter } from 'react-router-dom';

import BaseLayout from '@/layouts/BaseLayout';
import LoginPage from '@/pages/LoginPage';
import VideoDetailPage from '@/pages/VideoDetailPage';
import VideosPage from '@/pages/VideosPage';
import { RouteErrorElement } from '@/routes/RouteErrorElement';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <BaseLayout />,
    errorElement: <RouteErrorElement />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'videos', element: <VideosPage /> },
      { path: 'videos/:id', element: <VideoDetailPage /> },
    ],
  },
]);
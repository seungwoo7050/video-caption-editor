import { useParams } from 'react-router-dom';

export default function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <main style={{ padding: '24' }}>
      <h1>Video Detail</h1>
      <p>id: {id ?? "(missing)"}</p>
    </main>
  );
}